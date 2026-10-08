// PUBLISH-TIME-FROM-GATE (0.2.20 P1) — 발행 시각을 사람이 고르지 않고 «실측»에서 제안한다.
//
// 🩸 계기: 판 일정이 «컷 18:45 → 발행 20:00(75분)»처럼 잡혔는데 게이트 하나가 60분+ · 게이트 뒤 노드가 ~40분이다.
// ⭐ 자 = 최근 N(기본 3)개 완료된(`status: done` · 안정 버전) release-loop 런마다 «런 시작(≈ 컷) → 발행 노드 끝»을 재고 중앙값을 쓴다.
//    창은 «최근 N개 완료 런»으로 고정한다 — 못 잰 런 대신 더 옛 런을 끌어오지 않는다(옛 판이 지금 실측인 척 섞이지 않게).
//    런 시작 = 컷이다(예약 시작이 컷에 런을 띄운다) — preflight 의 «런 시작→발행 노드»와 같은 기점.
// ⛔ 못 잰 런은 0 으로 세지 않는다 — 건너뛰고 `skipped` 에 이유와 함께 남긴다. 표본이 0 이면 제안도 경고도 «없음»이다.
//
// 시각 출처(우선순위):
//   ① `nodes[]` 의 `startedAt`·`endedAt`(0.2.19~ 원장이 노드 시각을 적는다)
//   ② 옛 원장 — `<runId>.json.contexts/<n>.json` 의 mtime(노드 n 이 «시작할 때» 쓰인다) ⇒ 발행 노드 끝 ≈ 다음 노드 시작.
//      (preflight `releaseGateMeasure` 와 같은 근사 · 그 파일의 nodeId 가 path 와 맞을 때만 쓴다)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { releaseLedgerRoot } from '../../src/instance/resolve.js';

export const DEFAULT_PUBLISH_SAMPLE = 3;
/** 중앙값 위에 얹는 여유(분). 제안은 그 뒤 5분 단위로 올린다. */
export const DEFAULT_PUBLISH_MARGIN_MIN = 10;

const STABLE = /^\d+\.\d+\.\d+$/;

export interface PublishDurationSample {
  version: string;
  runId: string;
  startedAt: string;
  /** 런 시작 → 발행 노드 끝(초). */
  seconds: number;
  source: 'nodes' | 'contexts';
}

export interface PublishWindowMeasure {
  root: string;
  /** 중앙값에 쓴 표본(최신 먼저 · 최근 sample 개 완료 런 중 잰 것). */
  samples: PublishDurationSample[];
  /** 창 안의 완료 런이었지만 못 잰 것 — «0»이 아니라 «못 셈». */
  skipped: Array<{ runId: string; version: string; why: string }>;
  /** 표본이 없으면 null(측정 없음). */
  medianSeconds: number | null;
}

interface RunState {
  runId?: string;
  status?: string;
  startedAt?: string;
  path?: unknown;
  input?: { version?: string };
  nodes?: Array<{ nodeId?: string; startedAt?: string; endedAt?: string }>;
}

export function defaultReleaseGraphRunsRoot(ledgerRoot: string = releaseLedgerRoot()): string {
  return join(ledgerRoot, 'graph-runs', 'release-loop');
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function publishEndMs(root: string, file: string, state: RunState, path: string[]): { ms: number; source: PublishDurationSample['source'] } | null {
  const node = Array.isArray(state.nodes) ? state.nodes.find((n) => n?.nodeId === 'publish') : undefined;
  const ended = node?.endedAt ? Date.parse(node.endedAt) : NaN;
  if (Number.isFinite(ended)) return { ms: ended, source: 'nodes' };
  const index = path.indexOf('publish');
  const contexts = join(root, `${file}.contexts`);
  if (index < 0 || index + 1 >= path.length || !existsSync(contexts)) return null;
  const ctxPath = join(contexts, `${index + 2}.json`); // contexts/<n>.json 은 1부터 — 발행 다음 노드의 시작
  try {
    const ctx = JSON.parse(readFileSync(ctxPath, 'utf8')) as { nodeId?: string };
    return ctx.nodeId === path[index + 1] ? { ms: statSync(ctxPath).mtimeMs, source: 'contexts' } : null;
  } catch { return null; }
}

/** 최근 `sample` 개 완료 release-loop 런의 «런 시작 → 발행 노드 끝» 중앙값. */
export function measurePublishWindow(opts: { root?: string; sample?: number } = {}): PublishWindowMeasure {
  const root = opts.root ?? defaultReleaseGraphRunsRoot();
  const sample = Math.max(1, opts.sample ?? DEFAULT_PUBLISH_SAMPLE);
  const runs: Array<{ file: string; state: RunState; version: string; startedAt: string; startMs: number; path: string[] | null }> = [];
  if (existsSync(root)) {
    for (const file of readdirSync(root)) {
      if (!file.endsWith('.json') || file.includes('.decision')) continue;
      try {
        const state = JSON.parse(readFileSync(join(root, file), 'utf8')) as RunState;
        const v = state.input?.version;
        if (state.status !== 'done' || typeof v !== 'string' || !STABLE.test(v)) continue;
        // A completed stable run with a broken start or path is still «a run in the window» — it lands in `skipped`, not nowhere.
        const startedAt = typeof state.startedAt === 'string' ? state.startedAt : '';
        runs.push({ file, state, version: v, startedAt, startMs: Date.parse(startedAt), path: Array.isArray(state.path) ? state.path.filter((p): p is string => typeof p === 'string') : null });
      } catch { /* 못 읽은 원장은 표본이 아니다 */ }
    }
  }
  // Newest first; a run without a readable start sorts by its file mtime so it still takes its place in the window.
  const order = (run: (typeof runs)[number]) => (Number.isFinite(run.startMs) ? run.startMs : statSync(join(root, run.file)).mtimeMs);
  runs.sort((a, b) => order(b) - order(a));
  const samples: PublishDurationSample[] = [];
  const skipped: PublishWindowMeasure['skipped'] = [];
  for (const run of runs.slice(0, sample)) {
    const runId = run.state.runId ?? run.file.slice(0, -5);
    if (!Number.isFinite(run.startMs)) { skipped.push({ runId, version: run.version, why: 'startedAt 없음·무효' }); continue; }
    if (!run.path) { skipped.push({ runId, version: run.version, why: 'path 가 배열이 아님' }); continue; }
    if (!run.path.includes('publish')) { skipped.push({ runId, version: run.version, why: 'path 에 publish 노드 없음' }); continue; }
    const end = publishEndMs(root, run.file, run.state, run.path);
    const start = run.startMs;
    if (!end || end.ms < start) { skipped.push({ runId, version: run.version, why: '발행 노드 끝 시각을 못 읽음' }); continue; }
    samples.push({ version: run.version, runId, startedAt: run.startedAt, seconds: Math.round((end.ms - start) / 1000), source: end.source });
  }
  return { root, samples, skipped, medianSeconds: samples.length ? Math.round(median(samples.map((s) => s.seconds))) : null };
}

/** 제안 발행 시각 = 컷 + 중앙값 + 여유, 5분 단위로 올림. 측정이 없으면 null. */
export function proposePublishAt(cutAt: string, measure: PublishWindowMeasure, marginMin = DEFAULT_PUBLISH_MARGIN_MIN): string | null {
  if (measure.medianSeconds === null) return null;
  const raw = Date.parse(cutAt) + measure.medianSeconds * 1000 + marginMin * 60_000;
  const step = 5 * 60_000;
  return new Date(Math.ceil(raw / step) * step).toISOString();
}

export function kstHourMinute(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

const mins = (seconds: number) => Math.round(seconds / 60);

/** 발행 시각이 실측 중앙값보다 짧으면 한 줄 경고, 아니면 null(측정 없음도 null — 경고할 자가 없다). */
export function publishWindowWarning(cutAt: string, publishAt: string, measure: PublishWindowMeasure, marginMin = DEFAULT_PUBLISH_MARGIN_MIN): string | null {
  if (measure.medianSeconds === null) return null;
  const windowSeconds = (Date.parse(publishAt) - Date.parse(cutAt)) / 1000;
  if (windowSeconds >= measure.medianSeconds) return null;
  const proposed = proposePublishAt(cutAt, measure, marginMin)!;
  return `⚠️ 발행 시각이 실측 중앙값(${mins(measure.medianSeconds)}분)보다 짧다 — 컷→발행 ${mins(windowSeconds)}분 · 제안: ${kstHourMinute(proposed)} KST (최근 ${measure.samples.length}판 ${measure.samples.map((s) => s.version).join('·')} · +여유 ${marginMin}분)`;
}

/** `release schedule show` 의 한 줄 — 제안 발행 시각 또는 «측정 없음». */
export function formatPublishProposal(cutAt: string, measure: PublishWindowMeasure, marginMin = DEFAULT_PUBLISH_MARGIN_MIN): string {
  const proposed = proposePublishAt(cutAt, measure, marginMin);
  if (!proposed || measure.medianSeconds === null) {
    return `발행 제안 — 실측 없음(완료된 release-loop 런에서 발행 노드 시각을 못 읽었다 · 본 곳 ${measure.root}${measure.skipped.length ? ` · 못 잰 런 ${measure.skipped.length}` : ''})`;
  }
  return `발행 제안 ${kstHourMinute(proposed)} KST — 컷 + 실측 중앙값 ${mins(measure.medianSeconds)}분(최근 ${measure.samples.length}판 ${measure.samples.map((s) => `${s.version} ${mins(s.seconds)}분`).join(' · ')}) + 여유 ${marginMin}분`;
}
