/**
 * OPS-OVERVIEW-CLI 첫 조각 — 흐름 한 장의 «순수» 층(판정 · 이유 사슬 · 사람 표기).
 * 설계 = 내부 문서 `RFC-ops-overview-flow-health-cli-2026-10-08` §A1·A2.
 *
 * ⛔ 이 파일은 I/O 를 하지 않는다 — 수집은 `overview-collect.ts`, 자리 시대 임시 원천은 `overview-seat-era.ts`.
 * ⛔ «못 잼»은 `value:null` ⊕ `reason` 이다 — 절대 0 으로 읽지 않는다(판정도 그렇다).
 */

export type CellStatus = 'ok' | 'unmeasured' | 'partial';
export interface Cell<T> {
  value: T | null;
  source: string;
  observedAt: string | null;
  status: CellStatus;
  reason?: string;
}

export function okCell<T>(value: T, source: string, observedAt: string | null): Cell<T> {
  return { value, source, observedAt, status: 'ok' };
}
export function unmeasured<T>(source: string, reason: string, observedAt: string | null = null): Cell<T> {
  return { value: null, source, observedAt, status: 'unmeasured', reason };
}
export function measured(cell: Cell<unknown>): boolean {
  return cell.status !== 'unmeasured' && cell.value !== null;
}

/** 닫힌 판정 어휘 — 배열 순서가 곧 우선순위(위가 이긴다 · RFC §A1). */
export const VERDICTS = ['unobservable', 'blocked', 'loop-down', 'saturated', 'supply-empty', 'degraded', 'flowing'] as const;
export type Verdict = typeof VERDICTS[number];
export const VERDICT_LABEL: Record<Verdict, string> = {
  unobservable: '관측 불가', blocked: '막힘', 'loop-down': '루프 정지', saturated: '자원 포화',
  'supply-empty': '공급 부족', degraded: '흐름 저하', flowing: '흐름 정상',
};

export interface ReleaseRunInfo {
  runId: string; status: string; currentNode: string | null; startedAt: string | null;
  /** approval · freeze · gate · process-gone · none */
  waitingOn: 'approval' | 'gate' | 'process-gone' | 'none';
  elapsedMinutes: number | null;
}
export interface ScheduleInfo { cutAt: string; landBy: string | null; publishAt: string | null; freezeNow: boolean }
export interface ChecklistCounts { green: number; yellow: number; red: number; done: number; p0Yellow: number }
export interface OwnerTaskRow { handed: number; launched: number; prBound: number; failed: number; launchFailed: number }
export interface LaunchableInfo {
  count: number; ids: string[];
  skipped: { noTargetPath: number; predecessorOpen: number; alreadyHanded: number };
  /** 오케스트레이터의 «발사 가능» 술어가 아직 export 되지 않아 overview 가 임시로 계산했다(OVW-DISPATCH-LEDGER 가 대체). */
  interim: true;
}
export interface CapacityInfo { podUsed: number; podTarget: number; localUsed: number; localMax: number; free: number }
export interface MachineLoad { load1: number; load5: number; load15: number; cpuCount: number; freeGb: number; totalGb: number; ageSeconds: number }
export interface MachineRow { name: string; load: Cell<MachineLoad> }
export interface PodMemberRow { context: string; capacity: number; occupied: Cell<number> }
export interface ParentsInfo { count: number; staleOver6h: number; oldestHours: number | null }
export interface LoopRow {
  name: string;
  /** product = 제품 원장 · seat-era = 자리 시대 원천(제품 밖 · 임시) */
  era: 'product' | 'seat-era';
  beat: Cell<{ lastAt: string; ageSeconds: number; alive: boolean | null }>;
  /** 이 주기 이상 박동이 없으면 정지로 본다. null = 주기를 모른다 → 판정에서 뺀다(«죽었다»로 읽지 않는다). */
  staleAfterSeconds: number | null;
}

export interface OverviewSnapshot {
  generatedAt: string;
  instanceRoot: string;
  since: string;
  release: {
    version: Cell<string>;
    run: Cell<ReleaseRunInfo | 'none'>;
    schedule: Cell<ScheduleInfo | 'none'>;
    checklist: Cell<ChecklistCounts>;
  };
  tasks: {
    byOwner: Cell<Record<string, OwnerTaskRow>>;
    done: Cell<number>;
    launchable: Cell<LaunchableInfo>;
    capacity: Cell<CapacityInfo>;
  };
  machines: {
    hosts: MachineRow[];
    pods: PodMemberRow[];
    parents: Cell<ParentsInfo>;
  };
  landings: Cell<{ count: number; recent: string[] }>;
  loops: LoopRow[];
}

export interface VerdictResult { verdict: Verdict; reasons: string[]; nextActions: string[] }

/** 부하/코어가 이 값을 넘으면 «기계 압박»(흐름 저하의 사유). 디스크 I/O 신호는 OVW-MACHINE-HB 전까지 없다. */
export const LOAD_PER_CORE_PRESSURE = 3;

export function computeVerdict(s: OverviewSnapshot): VerdictResult {
  const hits = new Map<Verdict, { reasons: string[]; actions: string[] }>();
  const hit = (v: Verdict, reason: string, action?: string): void => {
    const row = hits.get(v) ?? { reasons: [], actions: [] };
    row.reasons.push(reason);
    if (action) row.actions.push(action);
    hits.set(v, row);
  };

  // 관측 불가 — 판·공급·용량 셋 중 하나라도 못 잼.
  const core: Array<[string, Cell<unknown>]> = [
    ['판(발행 런)', s.release.run], ['판(체크리스트)', s.release.checklist],
    ['공급(발사 가능 칸)', s.tasks.launchable], ['용량(빈 자리)', s.tasks.capacity],
  ];
  for (const [name, cell] of core) {
    if (!measured(cell)) hit('unobservable', `${name} 못 잼(${cell.reason ?? '사유 없음'}) · 원천 ${cell.source}`, `계측 누락 칸: ${name}`);
  }

  // 막힘 — 발행 런이 승인을 기다리거나 동결 창.
  const run = s.release.run.value;
  if (run && run !== 'none' && run.waitingOn === 'approval') {
    hit('blocked', `발행 런 ${run.runId.slice(0, 8)} 노드 ${run.currentNode ?? '?'} 승인 대기${run.elapsedMinutes !== null ? ` ${run.elapsedMinutes}분` : ''}`, '결정 카드 확인 — `elanous decisions list`');
  }
  const sched = s.release.schedule.value;
  if (sched && sched !== 'none' && sched.freezeNow) hit('blocked', `동결 창 안(${s.release.version.value ?? '?'})`, '동결 해제 시각까지 착지 보류');

  // 루프 정지 — 주기를 아는 루프의 박동이 끊김 · 프로세스 부재.
  for (const loop of s.loops) {
    const beat = loop.beat.value;
    if (!beat) continue; // 못 잼은 «죽었다»가 아니다
    const tag = loop.era === 'seat-era' ? ' [자리 시대 원천]' : '';
    if (beat.alive === false) hit('loop-down', `${loop.name} 프로세스 없음(마지막 ${beat.lastAt})${tag}`, `${loop.name} 재기동`);
    else if (loop.staleAfterSeconds !== null && beat.ageSeconds > loop.staleAfterSeconds) {
      hit('loop-down', `${loop.name} 박동 ${Math.round(beat.ageSeconds / 60)}분 없음(한계 ${Math.round(loop.staleAfterSeconds / 60)}분)${tag}`, `${loop.name} 재기동`);
    }
  }

  // 자원 포화 / 공급 부족 — 같은 스냅숏의 두 칸으로만.
  const launchable = s.tasks.launchable.value;
  const capacity = s.tasks.capacity.value;
  if (launchable && capacity) {
    if (launchable.count > 0 && capacity.free <= 0) {
      hit('saturated', `발사 가능 칸 ${launchable.count} · 빈 자리 0 (Pod ${capacity.podUsed}/${capacity.podTarget} · 로컬 ${capacity.localUsed}/${capacity.localMax})`, '발사 늦추기 · 저우선 칸 보류(오케스트레이터)');
    } else if (launchable.count === 0 && capacity.free > 0) {
      const k = launchable.skipped;
      hit('supply-empty', `빈 자리 ${capacity.free} · 발사 가능 칸 0 — 대상 경로 없음 ${k.noTargetPath} · 선행 미완 ${k.predecessorOpen} · 이미 넘김 ${k.alreadyHanded}`, '노란 칸 접지(대상 경로 채우기) — 스튜어드');
    }
  }

  // 흐름 저하 — 묵은 부모 · 기계 압박.
  const parents = s.machines.parents.value;
  if (parents && parents.staleOver6h > 0) hit('degraded', `6시간 넘은 하니스 부모 ${parents.staleOver6h}(최고 ${parents.oldestHours}h)`, '고아 정리 — reaper');
  for (const host of s.machines.hosts) {
    const l = host.load.value;
    if (l && l.cpuCount > 0 && l.load5 / l.cpuCount > LOAD_PER_CORE_PRESSURE) {
      hit('degraded', `${host.name} 부하 ${l.load5.toFixed(0)}/${l.cpuCount}코어(5분)`, `${host.name} 로컬 레인 닫기 검토`);
    }
  }

  for (const v of VERDICTS) {
    const row = hits.get(v);
    if (!row) continue;
    // 이유 사슬: 이긴 판정의 사유 먼저, 그 밑에 진 판정들의 사유도 «부가»로 남긴다(한 사슬에 두 원인이 보이게).
    const rest = VERDICTS.filter((o) => o !== v && hits.has(o)).flatMap((o) => hits.get(o)!.reasons.map((r) => `(+${VERDICT_LABEL[o]}) ${r}`));
    return { verdict: v, reasons: [...row.reasons, ...rest], nextActions: row.actions };
  }
  return { verdict: 'flowing', reasons: [], nextActions: [] };
}

/** exit code — flowing·degraded 0 · 그 밖의 판정 3(수집기 자체 실패 1 은 호출자 몫). */
export function verdictExitCode(v: Verdict): number {
  return v === 'flowing' || v === 'degraded' ? 0 : 3;
}

export function unmeasuredCells(s: OverviewSnapshot): string[] {
  const out: string[] = [];
  const visit = (name: string, cell: Cell<unknown>): void => { if (cell.status === 'unmeasured') out.push(`${name}: ${cell.reason ?? ''}`); };
  visit('release.version', s.release.version); visit('release.run', s.release.run);
  visit('release.schedule', s.release.schedule); visit('release.checklist', s.release.checklist);
  visit('tasks.byOwner', s.tasks.byOwner); visit('tasks.done', s.tasks.done);
  visit('tasks.launchable', s.tasks.launchable); visit('tasks.capacity', s.tasks.capacity);
  for (const h of s.machines.hosts) visit(`machines.${h.name}`, h.load);
  for (const p of s.machines.pods) visit(`pods.${p.context}`, p.occupied);
  visit('machines.parents', s.machines.parents); visit('landings', s.landings);
  for (const l of s.loops) visit(`loops.${l.name}`, l.beat);
  return out;
}

/** 사람 표기의 한 칸 — 못 잼은 `못 잼(<사유>)`. */
export function show<T>(cell: Cell<T>, fmt: (v: T) => string): string {
  if (cell.status === 'unmeasured' || cell.value === null) return `못 잼(${cell.reason ?? '사유 없음'})`;
  return fmt(cell.value) + (cell.status === 'partial' && cell.reason ? ` (${cell.reason})` : '');
}

function kst(iso: string | null | undefined): string {
  if (!iso) return '?';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t + 9 * 3600_000);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function renderOverview(s: OverviewSnapshot, v: VerdictResult, meta: { elapsedMs: number }): string {
  const lines: string[] = [];
  const mark = v.verdict === 'flowing' ? '✅' : v.verdict === 'degraded' ? '⚠️' : '⛔';
  lines.push(`${mark} ${VERDICT_LABEL[v.verdict]} (${v.verdict})`);
  for (const r of v.reasons) lines.push(`   ↳ ${r}`);
  for (const a of v.nextActions) lines.push(`   → 다음 행동(제안): ${a}`);
  const rel = s.release;
  const runText = show(rel.run, (r) => r === 'none' ? '런 없음' : `런 ${r.runId.slice(0, 8)} ${r.status} · 노드 ${r.currentNode ?? '-'} · 대기 ${r.waitingOn}${r.elapsedMinutes !== null ? ` · ${r.elapsedMinutes}분` : ''}`);
  const schedText = show(rel.schedule, (x) => x === 'none' ? '컷 미정' : `컷 ${kst(x.cutAt)} · 착지 마감 ${kst(x.landBy)}${x.publishAt ? ` · 발행 ${kst(x.publishAt)}` : ''}${x.freezeNow ? ' · 동결 중' : ''}`);
  const clText = show(rel.checklist, (c) => `초록 ${c.green} 노랑 ${c.yellow} 빨강 ${c.red} · P0 노랑 ${c.p0Yellow}`);
  lines.push(`판     ${show(rel.version, (x) => x)} · ${runText}`);
  lines.push(`       ${schedText} · ${clText}`);
  const owners = show(s.tasks.byOwner, (rows) => Object.entries(rows).sort().map(([o, r]) => `${o} 넘김 ${r.handed} 발사 ${r.launched}(PR ${r.prBound}) 실패 ${r.failed + r.launchFailed}`).join(' · ') || '오늘 카드 0');
  lines.push(`일꾼   ${owners} · 끝 ${show(s.tasks.done, String)}`);
  lines.push(`       발사 가능 ${show(s.tasks.launchable, (l) => `${l.count}${l.interim ? '(임시 술어)' : ''} · 대상 경로 없음 ${l.skipped.noTargetPath} · 선행 미완 ${l.skipped.predecessorOpen} · 이미 넘김 ${l.skipped.alreadyHanded}`)}`);
  lines.push(`       빈 자리 ${show(s.tasks.capacity, (c) => `${c.free} (Pod ${c.podUsed}/${c.podTarget} · 로컬 ${c.localUsed}/${c.localMax})`)} [${s.tasks.capacity.source}]`);
  const hosts = s.machines.hosts.map((h) => `${h.name} ${show(h.load, (l) => `${l.load1.toFixed(0)}/${l.cpuCount}코어 여유 ${l.freeGb.toFixed(0)}/${l.totalGb.toFixed(0)}GB (${l.ageSeconds}s 전)`)}`);
  lines.push(`기계   ${hosts.join(' · ') || '못 잼(하트비트 원장 비어 있음)'}`);
  lines.push(`       Pod ${s.machines.pods.map((p) => `${p.context} ${show(p.occupied, String)}/${p.capacity}`).join(' · ') || '못 잼(풀 설정 없음)'}`);
  lines.push(`       하니스 부모(이 기계) ${show(s.machines.parents, (p) => `${p.count} · 6h 넘음 ${p.staleOver6h}${p.oldestHours !== null ? ` · 최고 ${p.oldestHours}h` : ''}`)}`);
  lines.push(`착지   ${s.since} ${show(s.landings, (l) => `${l.count}`)} [${s.landings.source}]`);
  for (const l of s.loops) {
    lines.push(`루프   ${l.name}${l.era === 'seat-era' ? ' [자리 시대 원천]' : ''} ${show(l.beat, (b) => `${kst(b.lastAt)} (${Math.round(b.ageSeconds / 60)}분 전)${b.alive === null ? '' : b.alive ? ' 살아 있음' : ' 프로세스 없음'}${l.staleAfterSeconds === null ? ' · 주기 미상(판정 제외)' : ''}`)}`);
  }
  lines.push(`우주 ${s.instanceRoot} · ${kst(s.generatedAt)} KST · ${meta.elapsedMs}ms`);
  return lines.join('\n');
}
