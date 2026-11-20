'use client';

/**
 * I0 착지 — `/app/intake` 첫 입구 페이지.
 * 데몬 입구 셋(absorb · wish · harness ask)에 판정만 먼저 물어
 * (POST /v1/intake/route · dryRun), 자동 제출은 하지 않는다.
 *   N1  빈 입력이면 세 동작 버튼이 disabled
 *   N5a URL 치면 판정 칩(흡수 · auto-submit 0)만
 *   N6a 모르는 글은 사람 분류 버튼(classify)으로
 *   [self-review mustFix] 데몬 부재·가용성 미확인 시 세 버튼 disabled(15s 재탐침) ·
 *   판정 실패는 칩을 지우지 않고 배너(성공 시 해제) · 입력이 바뀌면 onChange 에서 칩·결과·진행 중 응답을 동기 파기한다.
 * 원문은 저장·로그에 통째로 안 남는다(preview 40자).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import {
  intakeTextPreview,
  routeIntake,
  submitAbsorb,
  submitGraph,
  submitWishCard,
  type IntakeRouteDecision,
} from '@/lib/intake-front-door-api';

type Pending = 'absorb' | 'tasks' | 'graph';

/** 500ms — URL/미분류 칩 대기 5s 안에 잡히게. */
const ROUTE_DEBOUNCE_MS = 500;

/** 제출마다 고유 ref — createWishCard 멱등 키라, 고정 ref 면 두 번째 글이 첫 카드에 먹힌다. */
function newWishRef(): string {
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `intake-${id}`;
}

const TRACK_LABEL: Record<string, string> = {
  absorb: '흡수',
  tasks: '과제',
  graph: '그래프',
  'ask-human': '사람 분류',
};

export default function IntakeFrontDoorPage() {
  const { client, sessionId, daemonAvailable } = useDaemon();
  const [text, setText] = useState('');
  const [decision, setDecision] = useState<IntakeRouteDecision | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** must1 — 입력 세대. 텍스트가 바뀌면 올라가고, 오래된 판정 응답은 파기한다. */
  const routeSeq = useRef(0);
  /** JUD-B must1 — 정규화한 (track, text) → ref. 실패·미확인(응답 유실) 뒤 재시도(중간에 다른 글이 성공했어도)는 같은 ref 를 재사용해 서버 멱등이 중복 카드를 막는다. 확정 성공 시 그 키만 지운다. */
  const pendingRefs = useRef<Map<string, string>>(new Map());

  /** JUD-B must1 — 제출은 동시에 1건만. ref 는 동기 가드, state 는 UI disabled 용. */
  const inFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  const trimmed = text.trim();
  const empty = trimmed.length === 0;

  const decide = useCallback(
    async (value: string, opts?: { classify?: boolean }) => {
      if (!value.trim()) {
        setDecision(null);
        return;
      }
      // must1 — 이 요청의 세대. await 뒤 세대가 바뀌었으면(입력이 바뀌었으면) 응답을 파기한다.
      const seq = ++routeSeq.current;
      setDeciding(true);
      try {
        const next = await routeIntake(client, value, opts);
        if (seq !== routeSeq.current) return;
        setRouteError(null); // r2 mustFix — 같은 입력 재시도 성공 시 이전 '판정 실패' 배너 해제
        setDecision(next);
      } catch (err) {
        if (seq !== routeSeq.current) return;
        // must2 — 판정 실패: 칩·버튼은 유지하고 오류 배너로 알린다.
        setRouteError(`판정 실패: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (seq === routeSeq.current) setDeciding(false);
      }
    },
    [client],
  );

  // 칩 debounce — 마지막 글자만 판정 요청(입력 무효화는 onChange 에서 동기로).
  useEffect(() => {
    if (empty) return;
    debounceTimer.current = setTimeout(() => {
      void decide(text);
    }, ROUTE_DEBOUNCE_MS);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [text, empty, decide]);

  const onClassify = useCallback((): void => {
    void decide(text, { classify: true });
  }, [decide, text]);

  const runTrack = useCallback(
    async (track: Pending): Promise<void> => {
      if (empty || inFlight.current) return;
      inFlight.current = true;
      setSubmitting(true);
      setResult(null);
      try {
        if (track === 'absorb') {
          const r = await submitAbsorb(client, text);
          setResult(`흡수 완료 · added=${r.added} merged=${r.merged} · ${r.ids.join(', ')}`);
        } else if (track === 'tasks') {
          const key = `${track}\u0000${text.trim().replace(/\s+/g, ' ')}`;
          const refs = pendingRefs.current;
          let ref = refs.get(key);
          if (!ref) {
            ref = newWishRef();
            refs.set(key, ref);
            if (refs.size > 20) refs.delete(refs.keys().next().value as string); // 오래된 항목부터 버림
          }
          const r = await submitWishCard(client, text, sessionId, ref);
          refs.delete(key); // 확정 성공 — 이 키만 비운다(같은 글 재제출은 새 ref)
          setResult(`과제 카드 ${r.created ? '생성' : '기존'} · ${r.cardId} · ${r.title}`);
        } else {
          const r = await submitGraph(client, text);
          setResult(`그래프 접수 · acceptanceId=${r.acceptanceId}`);
        }
      } catch (err) {
        setResult(`실패: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        inFlight.current = false;
        setSubmitting(false);
      }
    },
    [client, empty, text, sessionId],
  );

  const trackLabel = decision ? (TRACK_LABEL[decision.track] ?? decision.track) : null;

  return (
    <main className="intake-page">
      <h1>접수</h1>
      <p className="intake-hint">무엇이든 붙여 넣으면 갈래를 먼저 판정한다. 제출은 직접.</p>
      <textarea
        data-testid="intake-front-door-field"
        placeholder="무엇을 도울까요?"
        value={text}
        onChange={(e) => {
          const next = e.target.value;
          // r2 mustFix — 상태 갱신과 같은 배치로 동기 무효화(첫 렌더부터 새 입력에 이전 칩이 안 남게).
          routeSeq.current++;
          setDecision(null);
          setDeciding(false);
          setResult(null);
          setRouteError(null);
          setText(next);
        }}
        readOnly={submitting}
        rows={5}
      />
      <div className="intake-actions">
        <button
          type="button"
          data-testid="intake-absorb"
          disabled={empty || !daemonAvailable || submitting}
          onClick={() => void runTrack('absorb')}
        >
          흡수
        </button>
        <button
          type="button"
          data-testid="intake-split"
          disabled={empty || !daemonAvailable || submitting}
          onClick={() => void runTrack('tasks')}
        >
          과제 만들기
        </button>
        <button
          type="button"
          data-testid="intake-graph"
          disabled={empty || !daemonAvailable || submitting}
          onClick={() => void runTrack('graph')}
        >
          그래프에 묻기
        </button>
      </div>
      {deciding ? <p className="intake-deciding">판정 중…</p> : null}
      {decision && trackLabel ? (
        <p
          className="intake-route-chip"
          data-testid="intake-route-chip"
          data-auto-submit="0"
          data-track={decision.track}
          data-decided-by={decision.decidedBy}
        >
          {' '}
          <span data-testid="intake-route-chip-label">{trackLabel}</span> · {decision.reason}{' '}
          {decision.track === 'ask-human' ? (
            <button type="button" data-testid="intake-route-classify" onClick={onClassify}>
              분류
            </button>
          ) : null}
        </p>
      ) : null}
      {routeError ? (
        <p className="intake-route-error" data-testid="intake-route-error" role="alert">
          {routeError}
        </p>
      ) : null}
      {result ? (
        <p className="intake-result" data-testid="intake-result">
          {result}
        </p>
      ) : null}
      <p className="intake-preview">{intakeTextPreview(text) || '(빈 입력)'}</p>
    </main>
  );
}