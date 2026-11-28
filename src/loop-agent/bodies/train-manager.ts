// 기차 매니저 (train-manager · L0 TC) — v2 supervisor card that DELEGATES to the land-steward's train manager (decision 11-27
// «3 planes: land-steward = production landing» · #40380). One body only: src/land-graph/lane-order.ts (lanes · lane order) and
// the land graph, which walks the lane order of the policy pack graphs/loop-agents/land-steward/policies.yaml ⊕ its runtime pins.
//
// SUPERVISORS-EXECUTE-NOT-PROPOSE (대표 11-28 17:3x · L4 «감지 → TC 에 제안 우편 → 아무도 적용 안 함 → 2→10/60분»): the card
// APPLIES the lane pin itself — a runtime pin with a TTL (agent.yaml authority · pin_ttl_min · pins_active_max) the land graph
// walks on its next tick; TC gets one FYI line, not a request. Undo = release-pin (also automatic: TTL · the lane closed).
//
// 세 얼굴: 관측 = land-graph ledger (churn refusals · lands in the last hour) ⊕ open PRs → land-steward `lanes()` ⊕ pack ⊕ runtime pins /
// 판단 근거 = KPI hot_file_churn_refusals (60 min) ≤ 0 · a lane whose PRs churned and has no pin (pack or runtime) /
// 수복과 인계 = apply-pin (runtime pin ⊕ FYI to TC · undo release-pin) · a pin write that fails → propose-pin (the old mail) · a
// breach it cannot close → TC.
import { CHURN_REFUSALS, type LedgerRow, type PrInfo } from '../../land-graph/land-graph.js';
import { lanes as stewardLanes, loadLandPolicy, trainOrderOf, type Lane, type LandPolicy } from '../../land-graph/lane-order.js';
import { landOrder } from '../../land-graph/land-graph.js';
import type { RuntimePin } from '../../kit/lane-pins/index.js';
import type { AgentCard } from '../card.js';
import { livePostResult } from '../live.js';
import type { BodyEnv } from '../registry.js';
import type { AgentBody, Observation } from '../runtime.js';
import { pn } from '../policy-context.js';

export const AGENT_ID = 'train-manager';

export interface TrainManagerDeps {
  readLedger(): LedgerRow[] | null;
  listPrs(): Promise<PrInfo[] | null>;
  /** the land-steward policy pack (null = none · its pins are the lanes already ordered) */
  policy(): LandPolicy | null;
  /** id = sent · null = already sent (dedupe) · false = could not send (store / mail error) */
  post(key: string, to: string, body: string, kind?: string): number | string | null | false;
  /** SUPERVISORS-EXECUTE-NOT-PROPOSE: the unexpired runtime pins (null = unreadable) · put one (throws on a failed write) · drop
   *  one. Absent (a world without the kit) = the card proposes the pin by mail, as before. */
  runtimePins?(nowMs: number): readonly RuntimePin[] | null;
  putPin?(pin: RuntimePin, nowMs: number): void;
  releasePin?(file: string, nowMs: number): boolean;
}

const isChurn = (r: LedgerRow): boolean => r.event === 'refused' && !!r.cls && CHURN_REFUSALS.includes(r.cls) && !r.synthetic;
export const laneKey = (l: Pick<Lane, 'file'>): string => `lane:${l.file}`;
/** DETECT-TO-ACTION (11-28 journal: «행동 0/3 · 거절 3» every tick — the same first 3 lanes hit their 30-min cooldown while
 *  7 hot lanes were never proposed): a lane whose pin for THIS train order was already sent is not planned again, so
 *  max_per_tick goes to the lanes nobody has proposed yet. A new order (a PR joined or left) is a new proposal. */
const pinKey = (file: string): string => `pin:${file}`;
export const pinSentKey = (l: Pick<Lane, 'file'> & { order: readonly number[] }): string => `pin-sent:${l.file}:${l.order.join('-')}`;

export function createBody(env: BodyEnv, deps: TrainManagerDeps = liveDeps(env.stateRoot, env.card)): AgentBody {
  let lastLanes: Array<Lane & { order: number[]; churn: number }> = [];
  let lastRuntime: readonly RuntimePin[] = [];
  return {
    async observe(ctx): Promise<Observation> {
      const rows = deps.readLedger(); const prs = await deps.listPrs();
      if (!rows) return { kpi: null, subjects: [], facts: ['unreadable: land ledger'] };
      if (!prs) {
        // the churn KPI is the ledger's own number — a gh outage must not hide a persisting churn from the L0
        const nowMs0 = ctx.now.getTime();
        lastLanes = [];
        return { kpi: rows.filter(r => nowMs0 - Date.parse(r.at) <= pn('churn_window_min') * 60_000).filter(isChurn).length, subjects: [], facts: ['open PRs unreadable (gh) — lanes unknown · KPI from the land ledger'] };
      }
      const nowMs = ctx.now.getTime();
      const recent = rows.filter(r => nowMs - Date.parse(r.at) <= pn('churn_window_min') * 60_000);
      const churn = recent.filter(isChurn);
      const pack = deps.policy();
      lastRuntime = deps.runtimePins?.(nowMs) ?? [];
      const pinned = new Set([...(pack?.laneOrder.pins ?? []), ...lastRuntime].map(p => p.file));
      // the train order = the pack's train keys (policies.yaml) · a pack without them → the shipped pack's · none → the body's order
      const train = pack?.laneOrder.train ?? loadLandPolicy()?.laneOrder.train ?? null;
      const order = (train ? trainOrderOf(train) : landOrder)(prs.filter(p => p.state === 'OPEN'), rows, nowMs).map(p => p.number);
      lastLanes = stewardLanes(prs).map(l => ({ ...l, order: order.filter(n => l.prs.includes(n)), churn: churn.filter(r => l.prs.includes(r.pr)).length }));
      const open = lastLanes.filter(l => l.churn > 0 && !pinned.has(l.file));
      // a runtime pin whose lane has fewer than two of its PRs still open has nothing left to order → release it (auto-release)
      const done = lastRuntime.filter(p => (lastLanes.find(l => l.file === p.file)?.prs.filter(n => p.prs.includes(n)).length ?? 0) < 2);
      return {
        kpi: churn.length,
        subjects: [
          ...open.map(l => ({ id: laneKey(l), kind: 'hot-lane', summary: `${l.file} · ${l.prs.map(n => `#${n}`).join(',')} · churn ${l.churn} · train order ${l.order.map(n => `#${n}`).join('→')}` })),
          ...done.map(p => ({ id: laneKey(p), kind: 'pin-done', summary: `runtime pin ${p.file} (${p.prs.map(n => `#${n}`).join('→')}) · lane closed` })),
        ],
        facts: [`lands ${recent.filter(r => r.event === 'landed' && !r.synthetic).length} in ${pn('churn_window_min')} min`, `lanes ${lastLanes.length} · pinned ${pinned.size}${deps.putPin ? ` (runtime ${lastRuntime.length}/${pn('pins_active_max')})` : ''}`, 'body = land-steward train manager ⊕ policies.yaml ⊕ runtime pins'],
      };
    },
    // SUPERVISORS-EXECUTE-NOT-PROPOSE: a churning unpinned lane → apply-pin (within the free pin slots) · a closed lane → release-pin
    plan: (obs, ctx) => {
      if (!deps.putPin) return obs.subjects.filter(s => { const l = lastLanes.find(x => laneKey(x) === s.id); return !l || !ctx.state.acted[pinSentKey(l)]; })
        .map(s => ({ action: 'propose-pin', target: s.id, why: s.summary }));
      const free = Math.max(0, pn('pins_active_max') - lastRuntime.length);
      return [...obs.subjects.filter(s => s.kind === 'pin-done').map(s => ({ action: 'release-pin', target: s.id, why: s.summary })),
        ...obs.subjects.filter(s => s.kind === 'hot-lane').slice(0, free).map(s => ({ action: 'apply-pin', target: s.id, why: s.summary }))];
    },
    actions: {
      'apply-pin': {
        describe: '핫파일 차선 하나에 기차 순서 핀을 직접 건다(런타임 핀 · TTL pin_ttl_min · 동시 pins_active_max · land-graph 가 다음 틱에 이 순서로 착지 · TC 에 FYI 한 줄 · 되돌림 release-pin)',
        run(target, ctx) {
          const lane = lastLanes.find(l => laneKey(l) === target);
          if (!lane || lane.order.length < 2) return { ok: false, line: `${target}: 지금 보이는 핫파일 차선이 아니다(열린 PR 2개 미만)` };
          const nowMs = ctx.now.getTime();
          if (!deps.putPin) return { ok: false, line: `${target}: 런타임 핀 문 없음 — propose-pin 으로` };
          if ((deps.runtimePins?.(nowMs) ?? lastRuntime).length >= pn('pins_active_max')) return { ok: false, line: `${target}: 런타임 핀 상한 ${pn('pins_active_max')} — 핀 하나가 풀리면 다음 틱` };
          const until = new Date(nowMs + pn('pin_ttl_min') * 60_000).toISOString();
          deps.putPin({ file: lane.file, prs: lane.order, by: ctx.card.address, at: ctx.now.toISOString(), until }, nowMs);
          const seq = lane.order.map(n => `#${n}`).join('→');
          // FYI, not a request: nobody has to act for the pin to work (mail failure never undoes the pin)
          const id = deps.post(`train-pin-applied:${lane.file}:${lane.order.join('-')}`, 'TC',
            `[기차 매니저 · 핀 적용 · 회신 불필요] 핫파일 차선 ${lane.file} — 같은 파일 충돌 거부 ${lane.churn}건(${pn('churn_window_min')}분) · 착지 순서 ${seq} 핀을 걸었다(런타임 · ~${until.slice(11, 16)}Z 자동 해제). 되돌림: @loop:train-manager «release-pin ${target}» · 영구로 두려면 policies.yaml lane_order.pins PR`, 'info');
          return { ok: true, line: `${target} 핀 적용 ${seq} · ~${until.slice(11, 16)}Z${id ? ` · FYI TC #${id}` : ''}`, ref: pinKey(lane.file), undo: `release-pin ${target}`, before: `unpinned · churn ${lane.churn}`, after: `pinned ${seq} until ${until}` };
        },
      },
      'release-pin': {
        describe: '런타임 핀 하나를 푼다(apply-pin 의 되돌림 · 차선이 닫혔을 때 자동 · 정책 팩 핀은 안 건드림)',
        run(target, ctx) {
          const file = target.startsWith('lane:') ? target.slice('lane:'.length) : target;
          if (!deps.releasePin?.(file, ctx.now.getTime())) return { ok: true, line: `${target}: 런타임 핀 없음(이미 만료·해제)` };
          return { ok: true, line: `${target} 런타임 핀 해제`, ref: pinKey(file), undo: `apply-pin ${target}` };
        },
      },
      'propose-pin': {
        describe: '착지 집사 정책 팩(graphs/loop-agents/land-steward/policies.yaml)에 넣을 차선 핀 하나를 TC 에 제안한다(우편 한 통 · 아무것도 쓰지 않음)',
        run(target, ctx) {
          const lane = lastLanes.find(l => laneKey(l) === target);
          if (!lane) return { ok: false, line: `${target}: 지금 보이는 차선이 아니다` };
          const yaml = `  - { file: ${lane.file}, prs: [${lane.order.join(', ')}] }`;
          const id = deps.post(`train-pin:${lane.file}:${lane.order.join('-')}`, 'TC',
            `[기차 매니저 → TC] 핫파일 차선 ${lane.file} 에 같은 파일 충돌 거부 ${lane.churn}건(${pn('churn_window_min')}분) — 정책 팩 lane_order.pins 에 이 줄을 넣으면 land-graph 가 이 순서로 착지한다:\n${yaml}\n(graphs/loop-agents/land-steward/policies.yaml · PR 로 · 순서 = 기차 순서 ${lane.order.map(n => `#${n}`).join('→')})`);
          if (id === false) return { ok: false, line: `${target} 핀 제안 우편 실패 — 다음 틱에 다시(쿨다운 뒤) · 실패는 사건으로 남는다` };
          ctx.state.acted[pinSentKey(lane)] = ctx.now.toISOString();
          return id === null ? { ok: true, line: `${target} 핀 제안 이미 보냄` } : { ok: true, line: `${target} 핀 제안 → TC #${id}`, ref: `msg:${id}` };
        },
      },
    },
  };
}

export function liveDeps(stateRoot: string, card?: AgentCard): TrainManagerDeps {
  return {
    readLedger() { try { return (require('../../land-graph/land-graph.js') as typeof import('../../land-graph/land-graph.js')).readLedger(stateRoot); } catch { return null; } },
    async listPrs() {
      try { return await (require('../../cli/land-graph-cli.js') as typeof import('../../cli/land-graph-cli.js')).defaultLandDeps().listPrs(); } catch { return null; }
    },
    policy() { try { return loadLandPolicy(); } catch { return null; } },
    post: (key, to, body, kind = 'info') => livePostResult(stateRoot, card, AGENT_ID)(key, to, body, kind),
    runtimePins(nowMs) { try { return (require('../../kit/lane-pins/index.js') as typeof import('../../kit/lane-pins/index.js')).readRuntimePins(stateRoot, nowMs); } catch { return null; } },
    putPin(pin, nowMs) { (require('../../kit/lane-pins/index.js') as typeof import('../../kit/lane-pins/index.js')).putRuntimePin(stateRoot, pin, nowMs); },
    releasePin(file, nowMs) { return (require('../../kit/lane-pins/index.js') as typeof import('../../kit/lane-pins/index.js')).releaseRuntimePin(stateRoot, file, nowMs); },
  };
}
