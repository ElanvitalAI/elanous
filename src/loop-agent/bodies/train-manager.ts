// 기차 매니저 (train-manager · L0 TC) — v2 supervisor card that DELEGATES to the land-steward's train manager (decision 11-27
// «3 planes: land-steward = production landing» · #40380). One body only: src/land-steward/train.ts (lanes · trainOrder) and
// the land graph, which walks the lane order of the policy pack graphs/loop-agents/land-steward/policies.yaml. This card keeps
// the supervisor's subject · KPI · voice · L0; its one action proposes a lane pin for that pack to TC — it writes nothing.
//
// 세 얼굴: 관측 = land-graph ledger (churn refusals · lands in the last hour) ⊕ open PRs → land-steward `lanes()` ⊕ the pack /
// 판단 근거 = KPI hot_file_churn_refusals (60 min) ≤ 0 · a lane whose PRs churned and has no pin in the pack /
// 수복과 인계 = propose-pin (one mail to TC with the YAML pin · undo = none, nothing written) · a breach it cannot close → TC.
import { CHURN_REFUSALS, type LedgerRow, type PrInfo } from '../../land-graph/land-graph.js';
import { lanes as stewardLanes, trainOrder, type Lane } from '../../land-steward/train.js';
import type { LandPolicy } from '../../land-steward/policy.js';
import type { AgentCard } from '../card.js';
import { livePostResult } from '../live.js';
import type { BodyEnv } from '../registry.js';
import type { AgentBody, Observation } from '../runtime.js';
import { pv } from '../policy-context.js';

export const AGENT_ID = 'train-manager';
/** KPI window: churn refusals counted over the last hour. */
export const CHURN_WINDOW_MIN = 60;

export interface TrainManagerDeps {
  readLedger(): LedgerRow[] | null;
  listPrs(): Promise<PrInfo[] | null>;
  /** the land-steward policy pack (null = none · its pins are the lanes already ordered) */
  policy(): LandPolicy | null;
  /** id = sent · null = already sent (dedupe) · false = could not send (store / mail error) */
  post(key: string, to: string, body: string): number | string | null | false;
}

const isChurn = (r: LedgerRow): boolean => r.event === 'refused' && !!r.cls && CHURN_REFUSALS.includes(r.cls) && !r.synthetic;
export const laneKey = (l: Pick<Lane, 'file'>): string => `lane:${l.file}`;

export function createBody(env: BodyEnv, deps: TrainManagerDeps = liveDeps(env.stateRoot, env.card)): AgentBody {
  let lastLanes: Array<Lane & { order: number[]; churn: number }> = [];
  return {
    async observe(ctx): Promise<Observation> {
      const rows = deps.readLedger(); const prs = await deps.listPrs();
      if (!rows) return { kpi: null, subjects: [], facts: ['unreadable: land ledger'] };
      if (!prs) {
        // the churn KPI is the ledger's own number — a gh outage must not hide a persisting churn from the L0
        const nowMs0 = ctx.now.getTime();
        lastLanes = [];
        return { kpi: rows.filter(r => nowMs0 - Date.parse(r.at) <= pv('churn_window_min', CHURN_WINDOW_MIN) * 60_000).filter(isChurn).length, subjects: [], facts: ['open PRs unreadable (gh) — lanes unknown · KPI from the land ledger'] };
      }
      const nowMs = ctx.now.getTime();
      const recent = rows.filter(r => nowMs - Date.parse(r.at) <= pv('churn_window_min', CHURN_WINDOW_MIN) * 60_000);
      const churn = recent.filter(isChurn);
      const pinned = new Set((deps.policy()?.laneOrder.pins ?? []).map(p => p.file));
      const order = trainOrder(prs.filter(p => p.state === 'OPEN'), rows, nowMs).map(p => p.number);
      lastLanes = stewardLanes(prs).map(l => ({ ...l, order: order.filter(n => l.prs.includes(n)), churn: churn.filter(r => l.prs.includes(r.pr)).length }));
      const open = lastLanes.filter(l => l.churn > 0 && !pinned.has(l.file));
      return {
        kpi: churn.length,
        subjects: open.map(l => ({ id: laneKey(l), kind: 'hot-lane', summary: `${l.file} · ${l.prs.map(n => `#${n}`).join(',')} · churn ${l.churn} · train order ${l.order.map(n => `#${n}`).join('→')}` })),
        facts: [`lands ${recent.filter(r => r.event === 'landed' && !r.synthetic).length} in ${pv('churn_window_min', CHURN_WINDOW_MIN)} min`, `lanes ${lastLanes.length} · pinned ${pinned.size}`, 'body = land-steward train manager ⊕ policies.yaml'],
      };
    },
    plan: (obs) => obs.subjects.map(s => ({ action: 'propose-pin', target: s.id, why: s.summary })),
    actions: {
      'propose-pin': {
        describe: '착지 집사 정책 팩(graphs/loop-agents/land-steward/policies.yaml)에 넣을 차선 핀 하나를 TC 에 제안한다(우편 한 통 · 아무것도 쓰지 않음)',
        run(target) {
          const lane = lastLanes.find(l => laneKey(l) === target);
          if (!lane) return { ok: false, line: `${target}: 지금 보이는 차선이 아니다` };
          const yaml = `  - { file: ${lane.file}, prs: [${lane.order.join(', ')}] }`;
          const id = deps.post(`train-pin:${lane.file}:${lane.order.join('-')}`, 'TC',
            `[기차 매니저 → TC] 핫파일 차선 ${lane.file} 에 같은 파일 충돌 거부 ${lane.churn}건(${pv('churn_window_min', CHURN_WINDOW_MIN)}분) — 정책 팩 lane_order.pins 에 이 줄을 넣으면 land-graph 가 이 순서로 착지한다:\n${yaml}\n(graphs/loop-agents/land-steward/policies.yaml · PR 로 · 순서 = 기차 순서 ${lane.order.map(n => `#${n}`).join('→')})`);
          if (id === false) return { ok: false, line: `${target} 핀 제안 우편 실패 — 다음 틱에 다시(쿨다운 뒤) · 실패는 사건으로 남는다` };
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
    policy() { try { return (require('../../land-steward/policy.js') as typeof import('../../land-steward/policy.js')).loadLandPolicy(); } catch { return null; } },
    post: (key, to, body) => livePostResult(stateRoot, card, AGENT_ID)(key, to, body, 'info'),
  };
}
